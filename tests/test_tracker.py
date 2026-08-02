import unittest
from datetime import date,datetime
from zoneinfo import ZoneInfo
from src.tracker import calculate_form,choose_checkpoint,normalize_name,rank_candidates
ET=ZoneInfo('America/New_York')
class TrackerTests(unittest.TestCase):
    def test_cumulative_score_tyrone(self):
        hrs=[0,0,0,1,1,0,0,0,1,0,0,0,0,1,1];games=[]
        for i,hr in enumerate(reversed(hrs),start=1):games.append({'date':f'2026-07-{i:02d}','gamePk':i,'homeRuns':hr,'plateAppearances':1})
        form=calculate_form(games,date(2026,8,1))
        self.assertEqual((form['hr_games_l5'],form['hr_games_l7'],form['hr_games_l15']),(2,2,5))
        self.assertAlmostEqual(form['score'],0.35238095238095235)
    def test_checkpoint_dst(self):
        cp=choose_checkpoint(datetime(2026,8,2,8,35,tzinfo=ET));self.assertEqual(cp.label,'08:17');self.assertEqual(cp.slate_date.isoformat(),'2026-08-02')
    def test_name_normalization(self):
        self.assertEqual(normalize_name('José Ramírez Jr.'),'joseramirez');self.assertEqual(normalize_name('C.J. Abrams'),'cjabrams')
    def test_rank(self):
        rows=[{'player':'Kyle','score':.1119,'hr_games_l5':0,'hr_games_l7':2,'hr_games_l15':2,'best_odds':575},{'player':'Tyrone','score':.3524,'hr_games_l5':2,'hr_games_l7':2,'hr_games_l15':5,'best_odds':700}]
        self.assertEqual(rank_candidates(rows)[0]['player'],'Tyrone')
if __name__=='__main__':unittest.main()
