import sys
import subprocess

def play_uri(query):
    # Fallback method using Windows protocol handler + Media play key
    cmd = f'start spotify:search:"{query}"'
    subprocess.run(cmd, shell=True)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        play_uri(" ".join(sys.argv[1:]))
