#!/usr/bin/env python3
from __future__ import annotations
import argparse,sys
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import datetime,timezone,date
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from src.model import *
from src.sources import *
from src.storage import *
def settle_old(c,files,now):
    for p in files:
        s=load_json(p,{});day=s.get('slate_date');changed=False
        if not day:continue
        sch=None;cache={}
        for key in ('top10','top20'):
            picks=(((s.get('portfolios') or {}).get(key) or {}).get('picks',[]))
            for x in picks:
                if x.get('settled') or not x.get('mlbam_id'):continue
                pid=int(x['mlbam_id'])
                try:cache.setdefault(pid,game_log(c,pid,int(day[:4])))
                except Exception as e:x['settlement_error']=str(e);continue
                if sch is None:
                    try:sch=schedule(c,date.fromisoformat(day))
                    except Exception:sch={}
                r=settle_pick(x,cache[pid],sch.get(int(x.get('team_id') or 0)))
                if r['settled']:x.update(r);x['settled_at']=now.isoformat();changed=True
            if picks:s['portfolios'][key]['summary']=portfolio_summary(picks)
        if changed:write_json(p,s)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--date');ap.add_argument('--checkpoint',choices=CHECKPOINTS);ap.add_argument('--force',action='store_true');a=ap.parse_args();now=datetime.now(timezone.utc);cp=explicit_checkpoint(a.date,a.checkpoint) if a.date and a.checkpoint else choose_checkpoint(now)
    if not cp:print('No ET checkpoint due');return 0
    data=ROOT/'data';sd=data/'snapshots';sp=sd/f'{cp.snapshot_id}.json';c=HttpClient();settle_old(c,sorted(sd.glob('*.json')),now)
    if sp.exists() and not a.force:rebuild(data,ROOT);print('Snapshot exists; settlement only');return 0
    snap={'schema_version':1,'snapshot_id':cp.snapshot_id,'slate_date':cp.slate_date.isoformat(),'checkpoint_et':cp.label,'scheduled_at_et':cp.scheduled_at.isoformat(),'observed_at':now.isoformat(),'observed_at_et':now.astimezone(ET).isoformat(),'status':'collecting','sources':{},'diagnostics':[],'portfolios':{}}
    try:vi=parse_vi(c.text(VI_URL),cp.slate_date);snap['sources']['vegas_insider']={k:v for k,v in vi.items() if k!='players'}
    except Exception as e:snap['status']='vegas_insider_unavailable';snap['diagnostics'].append(str(e));write_json(sp,snap);rebuild(data,ROOT);return 0
    try:dk=parse_dk(c.text(DK_URL),cp.slate_date);snap['sources']['draftkings']={'source':dk['source'],'source_url':dk['source_url'],'rows':len(dk['players'])}
    except Exception as e:dk={'players':[]};snap['sources']['draftkings']={'source':'DraftKings Network','source_url':DK_URL,'rows':0,'error':str(e)}
    if not vi['date_matches']:snap['status']='odds_not_posted_for_slate';write_json(sp,snap);rebuild(data,ROOT);return 0
    sch=schedule(c,cp.slate_date);dkmap={x['key']:x for x in dk['players']};cachep=data/'player_ids.json';ids=load_json(cachep,{})
    def person(r):return r['key'],ids.get(r['key']) or search_person(c,r['name'])
    resolved={}
    with ThreadPoolExecutor(max_workers=18) as ex:
        for f in as_completed([ex.submit(person,r) for r in vi['players']]):
            k,p=f.result();resolved[k]=p
            if p:ids[k]=p
    write_json(cachep,ids)
    logs={}
    def gl(r):
        p=resolved.get(r['key']);return r['key'],game_log(c,int(p['id']),cp.slate_date.year)
    with ThreadPoolExecutor(max_workers=18) as ex:
        fm={ex.submit(gl,r):r for r in vi['players'] if resolved.get(r['key'])}
        for f,r in fm.items():
            try:k,g=f.result();logs[k]=g
            except Exception as e:logs[r['key']]=e
    rows=[]
    for r in vi['players']:
        p=resolved.get(r['key']);g=logs.get(r['key'])
        if not p or not isinstance(g,list):continue
        form=calculate_form(g,cp.slate_date);gm=sch.get(int(p.get('teamId') or 0))
        if not form or game_has_started(gm,now):continue
        prices=list(r['prices']);d=dkmap.get(r['key'])
        if d:prices.append({'book':'DraftKings','odds':d['odds'],'url':d.get('url'),'verified':True,'event':d.get('event')})
        best=choose_best_price(prices)
        if not best or best['odds']<500:continue
        st=None
        if gm and gm.get('gameDate'):st=datetime.fromisoformat(gm['gameDate'].replace('Z','+00:00')).astimezone(ET).strftime('%-I:%M %p ET')
        rows.append({'player':p.get('fullName') or r['name'],'mlbam_id':int(p['id']),'team_id':p.get('teamId'),'slate_date':cp.slate_date.isoformat(),**form,'best_odds':int(best['odds']),'best_sportsbook':best['book'],'best_price_verified':bool(best.get('verified')),'all_prices':prices,'dk_odds':d['odds'] if d else None,'dk_url':d.get('url') if d else None,'game_pk':gm.get('gamePk') if gm else None,'game_time_utc':gm.get('gameDate') if gm else None,'game_time_et':st,'opponent':gm.get('opponent') if gm else None})
    ranked=rank_candidates(rows)
    for i,r in enumerate(ranked,1):r['rank']=i
    def pick(r):return {'rank':r['rank'],'player':r['player'],'mlbam_id':r['mlbam_id'],'team_id':r.get('team_id'),'slate_date':r['slate_date'],'score':r['score'],'hr_games_l5':r['hr_games_l5'],'hr_games_l7':r['hr_games_l7'],'hr_games_l15':r['hr_games_l15'],'home_runs_l15':r['home_runs_l15'],'odds':r['best_odds'],'sportsbook':r['best_sportsbook'],'best_price_verified':r['best_price_verified'],'dk_odds':r['dk_odds'],'dk_url':r['dk_url'],'all_prices':r['all_prices'],'game_pk':r['game_pk'],'game_time_utc':r['game_time_utc'],'game_time_et':r['game_time_et'],'opponent':r['opponent'],'settled':False,'result':'PENDING','home_runs':None,'profit_units':None}
    for key,n in (('top10',10),('top20',20)):
        picks=[pick(x) for x in ranked[:n]];snap['portfolios'][key]={'picks':picks,'summary':portfolio_summary(picks)}
    snap['eligible_candidates']=len(ranked);snap['status']='frozen' if ranked else 'no_eligible_players';write_json(sp,snap);rebuild(data,ROOT);print(sp.name,snap['status'],len(ranked));return 0
if __name__=='__main__':raise SystemExit(main())
