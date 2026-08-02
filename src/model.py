from __future__ import annotations
import re, unicodedata
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo
ET=ZoneInfo('America/New_York')
CHECKPOINTS=('08:17','11:17','17:17','20:17')
@dataclass(frozen=True)
class Checkpoint:
    slate_date: date; label: str; scheduled_at: datetime
    @property
    def snapshot_id(self): return f"{self.slate_date.isoformat()}_{self.label.replace(':','')}"
def normalize_name(v:str)->str:
    v=unicodedata.normalize('NFKD',v or '')
    v=''.join(c for c in v if not unicodedata.combining(c)).lower().replace('’',"'")
    v=re.sub(r'\b(jr|sr|ii|iii|iv)\.?\b','',v)
    v=re.sub(r'[^a-z0-9]+','',v)
    return {'kikehernandez':'enriquehernandez'}.get(v,v)
def american_odds(text:str)->int|None:
    m=re.findall(r'(?<!\d)([+-]\d{3,5})(?!\d)',(text or '').replace('−','-').replace('–','-'))
    return int(m[-1]) if m else None
def choose_checkpoint(now:datetime|None=None,tolerance_minutes:int=100)->Checkpoint|None:
    now=(now or datetime.now(timezone.utc)).astimezone(ET); out=[]
    for off in (0,-1):
        d=now.date()+timedelta(days=off)
        for label in CHECKPOINTS:
            h,m=map(int,label.split(':')); at=datetime.combine(d,time(h,m),ET); delta=now-at
            if timedelta(0)<=delta<=timedelta(minutes=tolerance_minutes): out.append(Checkpoint(d,label,at))
    return max(out,key=lambda x:x.scheduled_at) if out else None
def explicit_checkpoint(day:str,label:str)->Checkpoint:
    if label not in CHECKPOINTS: raise ValueError(label)
    d=date.fromisoformat(day); h,m=map(int,label.split(':'))
    return Checkpoint(d,label,datetime.combine(d,time(h,m),ET))
def calculate_form(games:Iterable[dict[str,Any]],slate:date)->dict[str,Any]|None:
    prior=[g for g in games if g.get('date') and date.fromisoformat(g['date'])<slate and int(g.get('plateAppearances',0))>0]
    prior.sort(key=lambda g:(g['date'],int(g.get('gamePk') or 0))); prior=prior[-15:]
    if len(prior)<15:return None
    recent=list(reversed(prior)); b=[int(int(g.get('homeRuns',0))>0) for g in recent]
    h5,h7,h15=sum(b[:5]),sum(b[:7]),sum(b)
    return {'score':.5*h5/5+.3*h7/7+.2*h15/15,'hr_games_l5':h5,'hr_games_l7':h7,'hr_games_l15':h15,'home_runs_l15':sum(int(g.get('homeRuns',0)) for g in recent),'recent_games':recent}
def rank_candidates(rows:list[dict[str,Any]])->list[dict[str,Any]]:
    return sorted(rows,key=lambda r:(-r['score'],-r['hr_games_l5'],-r['hr_games_l7'],-r['hr_games_l15'],-r['best_odds'],r['player']))
def choose_best_price(prices:list[dict[str,Any]])->dict[str,Any]|None:
    p=[x for x in prices if isinstance(x.get('odds'),int)]
    return max(p,key=lambda x:(x['odds'],bool(x.get('verified')),x.get('book',''))) if p else None
def game_has_started(game:dict|None,now:datetime)->bool:
    if not game:return False
    if str(game.get('abstractState','')).lower() in {'live','final'}:return True
    raw=game.get('gameDate')
    return bool(raw and now.astimezone(timezone.utc)>=datetime.fromisoformat(raw.replace('Z','+00:00')))
def settle_pick(pick:dict,games:list[dict],game:dict|None)->dict:
    rows=[g for g in games if g.get('date')==pick['slate_date'] and int(g.get('plateAppearances',0))>0]
    if rows:
        hr=sum(int(g.get('homeRuns',0)) for g in rows); win=hr>0
        return {'settled':True,'result':'WIN' if win else 'LOSS','home_runs':hr,'profit_units':pick['odds']/100 if win else -1.0}
    if game and str(game.get('abstractState','')).lower()=='final':return {'settled':True,'result':'PUSH','home_runs':0,'profit_units':0.0}
    return {'settled':False,'result':'PENDING','home_runs':None,'profit_units':None}
def portfolio_summary(picks:list[dict])->dict:
    s=[p for p in picks if p.get('settled')]; w=sum(p.get('result')=='WIN' for p in s); l=sum(p.get('result')=='LOSS' for p in s); pu=sum(p.get('result')=='PUSH' for p in s); g=w+l; net=sum(float(p.get('profit_units') or 0) for p in s)
    return {'selections':len(picks),'settled':len(s),'wins':w,'losses':l,'pushes':pu,'hit_rate':w/g if g else None,'net_units':net,'roi':net/g if g else None}
