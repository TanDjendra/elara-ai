import pychromecast
from pychromecast.controllers.youtube import YouTubeController
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
    target_title, target_vid = results[4]
    print(f"Playing video #5: {target_title} ({target_vid})")
    chromecasts, browser = pychromecast.get_chromecasts(timeout=5)
    if chromecasts:
        cast = chromecasts[0]
        cast.wait()
        yt = YouTubeController()
        cast.register_handler(yt)
        yt.play_video(target_vid)
        print("Casting successful!")
    pychromecast.discovery.stop_discovery(browser)
