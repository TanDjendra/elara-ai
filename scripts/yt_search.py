import urllib.request
import re

url = 'https://www.youtube.com/results?search_query=donnay'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
html = urllib.request.urlopen(req).read().decode('utf-8')

pattern = r'"videoRenderer":\{"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"\}'
matches = re.findall(pattern, html)

seen = set()
results = []
for vid, title in matches:
    if vid not in seen:
        seen.add(vid)
        results.append((title, vid))
        if len(results) >= 5:
            break

for idx, (title, vid) in enumerate(results, 1):
    print(f"{idx}. {title}")
