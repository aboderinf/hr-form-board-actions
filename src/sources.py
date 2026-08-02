from __future__ import annotations
import json,re,time,unicodedata
from datetime import date
from typing import Any
from urllib.parse import quote
import requests
from bs4 import BeautifulSoup
from .model import american_odds,normalize_name
VI_URL='https://www.vegasinsider.com/mlb/odds/player-props/home-runs/'
DK_URL='https://dknetwork.draftkings.com/draftkings-sportsbook-player-props/'
MLB='https://statsapi.mlb.com/api/v1'
class HttpClient:
    def __init__(self):
        self.s=requests.Session(); self.s.headers.update({'User-Agent':'Mozilla/5.0 (compatible; HRFormBoardActions/1.0)','Accept-Language':'en-US,en;q=.9'})
    def text(self,url):
        err=None
        for i in range(3):
            try:r=self.s.get(url,timeout=30);r.raise_for_status();return r.text
            except Exception as e:err=e;time.sleep(1.5*(i+1))
        raise RuntimeError(f'GET failed {url}: {err}')
    def json(self,url):return json.loads(self.text(url))
def _book(cell,i):
    h=' '.join([cell.get_text(' ',strip=True)]+[str(x.get('alt',''))+' '+str(x.get('src','')) for x in cell.find_all('img')]+[str(x.get('href',''))+' '+str(x.get('title','')) for x in cell.find_all('a')]).lower()
    for t,n in [('draftkings','DraftKings'),('fanduel','FanDuel'),('betmgm','BetMGM'),('caesars','Caesars'),('hardrock','Hard Rock Bet'),('bet365','bet365'),('espn','ESPN BET'),('fanatics','Fanatics'),('betrivers','BetRivers'),('bovada','Bovada')]:
        if t in h:return n
    return f'Vegas Insider Book {i+1} (unidentified)'
def parse_vi(page:str,expected:date)->dict:
    s=BeautifulSoup(page,'html.parser'); text=s.get_text(' ',strip=True); m=re.search(r'Home Run Odds\s+(\d{1,2})/(\d{1,2})(?:/(\d{4}))?',text,re.I); sd=date(int(m.group(3) or expected.year),int(m.group(1)),int(m.group(2))) if m else None
    table=next((t for t in s.find_all('table') if len(t.find_all('tr'))>50 or 'Home Runs' in ' '.join(r.get_text(' ',strip=True) for r in t.find_all('tr')[:8])),None)
    if not table:raise ValueError('VI table not found')
    headers=max((r.find_all(['th','td']) for r in table.find_all('tr')[:3]),key=len); books=[_book(c,i) for i,c in enumerate(headers[1:])]; players=[];seen=set()
    for r in table.find_all('tr'):
        c=r.find_all(['th','td'])
        if len(c)<2:continue
        name=re.sub(r'\s+',' ',c[0].get_text(' ',strip=True)).strip(); key=normalize_name(name)
        if not key or key in seen or american_odds(name) is not None or name.lower() in {'player','name'}:continue
        prices=[]
        for i,x in enumerate(c[1:]):
            o=american_odds(x.get_text(' ',strip=True))
            if o is not None:
                b=books[i] if i<len(books) else f'Vegas Insider Book {i+1} (unidentified)'; a=x.find('a'); prices.append({'book':b,'odds':o,'url':a.get('href') if a else None,'verified':'unidentified' not in b})
        if prices:seen.add(key);players.append({'name':name,'key':key,'prices':prices})
    if len(players)<20:raise ValueError(f'VI parser only {len(players)} players')
    return {'source':'Vegas Insider','source_url':VI_URL,'source_date':sd.isoformat() if sd else None,'date_matches':sd==expected,'books':books,'players':players}
def parse_dk(page:str,expected:date)->dict:
    s=BeautifulSoup(page,'html.parser'); table=next((t for t in s.find_all('table') if all(x in t.get_text(' ',strip=True) for x in ('Event','Market','Betslip Line','Odds'))),None)
    if not table:raise ValueError('DK table not found')
    out=[]
    for r in table.find_all('tr'):
        c=r.find_all(['th','td'])
        if len(c)<5:continue
        event,ds,market,line,ot=[x.get_text(' ',strip=True) for x in c[:5]]
        if not market.lower().endswith(' home runs') or not line.startswith('1+'):continue
        o=american_odds(ot); m=re.search(r'(\d{1,2})/(\d{1,2})',ds)
        if o is None or not m or date(expected.year,int(m.group(1)),int(m.group(2)))!=expected:continue
        name=re.sub(r'\s+Home Runs$','',market,flags=re.I).strip(); a=c[4].find('a'); out.append({'name':name,'key':normalize_name(name),'book':'DraftKings','odds':o,'event':event,'url':a.get('href') if a else None,'verified':True})
    return {'source':'DraftKings Network','source_url':DK_URL,'players':out}
def search_person(c:HttpClient,name:str)->dict|None:
    people=c.json(f'{MLB}/people/search?names={quote(name)}&sportIds=1&active=true').get('people',[])
    if not people:
        retry=re.sub(r'[^A-Za-z0-9 ]+','',unicodedata.normalize('NFKD',name)).strip(); people=c.json(f'{MLB}/people/search?names={quote(retry)}&sportIds=1&active=true').get('people',[]) if retry else []
    if not people:return None
    p=people[0];return {'id':p.get('id'),'fullName':p.get('fullName') or name,'teamId':(p.get('currentTeam') or {}).get('id')}
def game_log(c:HttpClient,pid:int,season:int)->list[dict]:
    splits=c.json(f'{MLB}/people/{pid}/stats?stats=gameLog&group=hitting&season={season}&gameType=R').get('stats',[{}])[0].get('splits',[])
    return [{'date':x.get('date'),'gamePk':(x.get('game') or {}).get('gamePk'),'opponent':(x.get('opponent') or {}).get('name'),'homeRuns':int((x.get('stat') or {}).get('homeRuns') or 0),'plateAppearances':int((x.get('stat') or {}).get('plateAppearances') or 0)} for x in splits]
def schedule(c:HttpClient,day:date)->dict[int,dict]:
    p=c.json(f'{MLB}/schedule?sportId=1&date={day.isoformat()}&hydrate=status,teams'); out={}
    for d in p.get('dates',[]):
      for g in d.get('games',[]):
        info={'gamePk':g.get('gamePk'),'gameDate':g.get('gameDate'),'status':(g.get('status') or {}).get('detailedState'),'abstractState':(g.get('status') or {}).get('abstractGameState')}; teams=g.get('teams') or {};h=(teams.get('home') or {}).get('team') or {};a=(teams.get('away') or {}).get('team') or {}
        if h.get('id'):out[int(h['id'])]={**info,'team':h.get('name'),'opponent':a.get('name')}
        if a.get('id'):out[int(a['id'])]={**info,'team':a.get('name'),'opponent':h.get('name')}
    return out
