import subprocess
import sys
import os

def download_audio(url, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    output_template = os.path.join(output_dir, "audio.%(ext)s")

    cmd = [
        "yt-dlp",
        "-x", "--audio-format", "wav",
        "--audio-quality", "0",
        "-o", output_template,
        "--no-playlist",
        url
    ]

    print(f"[VSProclamai] Baixando: {url}")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[ERRO] {result.stderr}", file=sys.stderr)
        sys.exit(1)

    print(f"[OK] Áudio baixado em: {output_dir}")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python download.py <url> <output_dir>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    output_dir = sys.argv[2]
    download_audio(url, output_dir)
