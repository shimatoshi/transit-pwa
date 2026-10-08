import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import collector as c

class CollectionTests(unittest.TestCase):
    def test_resume_deduplicates_but_keeps_calendars(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db = c.database(root)
            for day in [0, 1, 2, 0]:
                c.enqueue(db, f'train:{day}:123', 'train', 'https://example.test', {'day': day}, 20)
            db.commit()
            db.close()
            self.assertEqual(c.database(root).execute('SELECT count(*) FROM tasks').fetchone()[0], 3)

    def fixture(self, stop='A'):
        contents = {'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,駅A,35,139\nB,駅B,35.1,139.1\n',
                    'routes.txt': 'route_id,route_type\nR,0\n',
                    'trips.txt': 'route_id,service_id,trip_id\nR,W,T\n',
                    'stop_times.txt': f'trip_id,stop_id,stop_sequence,arrival_time,departure_time\nT,{stop},1,23:55:00,23:55:00\nT,B,2,24:05:00,24:05:00\n',
                    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,0,0,20260101,20270331\n'}
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            for name, content in contents.items():
                z.writestr(name, content)
        return stream.getvalue()

    def test_gtfs_keeps_tram_and_marks_expired(self):
        result = c.gtfs_summary(self.fixture(), today='20261008')
        self.assertEqual(result['rail_trips'], 1)
        self.assertEqual(result['rail_stops'], 2)
        self.assertFalse(result['expired'])
        self.assertTrue(c.gtfs_summary(self.fixture(), today='20270401')['expired'])

    def test_gtfs_rejects_unknown_stop(self):
        with self.assertRaisesRegex(ValueError, 'Unknown trip/stop'):
            c.gtfs_summary(self.fixture('BAD'))

    def test_detail_parses_midnight_and_both_times(self):
        html = '<title>停車駅一覧 - 駅探</title><table>'
        html += '<tr><td class="td-station-name"><a href="/station/1">駅A</a></td><td class="td-dep-and-arr-time">23:55発</td></tr>'
        html += '<tr><td class="td-station-name"><a href="/station/2">駅B</a></td><td class="td-dep-and-arr-time">00:05着 00:06発</td></tr></table>'
        result = c.html_parse('train', html.encode())
        self.assertEqual(result['stops'][1]['arrival'], '00:05')
        self.assertEqual(result['stops'][1]['departure'], '00:06')

if __name__ == '__main__':
    unittest.main()
