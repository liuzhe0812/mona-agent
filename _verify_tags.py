from pathlib import Path
from mona.distill.collectors.notes_collector import collect_notes_stats

s = collect_notes_stats(Path(r"D:\liuzhe\Documents\mona_notes"))
print("=== tag_distribution ===")
for t in s.tag_distribution:
    print(f"  {t['tag']}: {t['count']}")
print(f"\ntotal tags: {len(s.tag_distribution)}")
