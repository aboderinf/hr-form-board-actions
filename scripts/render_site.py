#!/usr/bin/env python3
from pathlib import Path
import json,sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from src.storage import render_site
payload=json.loads((ROOT/'data/index.json').read_text())
render_site(payload,ROOT/'index.html')
