from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from .model import portfolio_summary

SHELL='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HR Form Board — GitHub Actions</title><meta name="description" content="Independent GitHub Actions MLB home-run form tracker"><link rel="stylesheet" href="/style.css"></head><body><div id="app"><div class="shell"><div class="card empty">Loading tracked data…</div></div></div><script type="module" src="/app.js"></script></body></html>'''

def write_json(path:Path,payload:Any):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def load_json(path:Path,default:Any):
    try:return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:return default
def render_site(data:dict,out:Path):
    out.write_text(SHELL,encoding='utf-8')
def rebuild(data_dir:Path,root:Path):
    snaps=[load_json(p,{}) for p in sorted((data_dir/'snapshots').glob('*.json'))];agg={}
    for key in ('top10','top20'):
        picks=[]
        for s in snaps:picks.extend((((s.get('portfolios') or {}).get(key) or {}).get('picks',[])))
        agg[key]=portfolio_summary(picks)
    d={'generated_at':datetime.now(timezone.utc).isoformat(),'method':'0.50*L5 + 0.30*L7 + 0.20*L15 cumulative HR-game rates','checkpoints_et':['08:17','11:17','17:17','20:17'],'aggregate':agg,'snapshots':snaps};write_json(data_dir/'index.json',d);render_site(d,root/'index.html')
