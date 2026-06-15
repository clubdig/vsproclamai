import subprocess
import sys
import os
import glob

def separate_audio(input_file, output_dir):
    os.makedirs(output_dir, exist_ok=True)

    print(f"[VSProclamai] Separando stems de: {input_file}")
    print("[INFO] Usando Demucs (Meta) para separação de áudio...")

    cmd = [
        sys.executable, "-m", "demucs",
        "--out", output_dir,
        "--name", "htdemucs",
        "--two-stems", "vocals",
        input_file
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print("[INFO] Tentando separação completa (4 stems)...")
        cmd = [
            sys.executable, "-m", "demucs",
            "--out", output_dir,
            "--name", "htdemucs",
            input_file
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[ERRO] Falha na separação: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    # Organizar stems
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    demucs_dir = os.path.join(output_dir, "htdemucs", base_name)

    if os.path.exists(demucs_dir):
        stem_map = {
            "vocals.wav": "vocals.wav",
            "drums.wav": "drums.wav",
            "bass.wav": "bass.wav",
            "other.wav": "other.wav",
            "no_vocals.wav": "instrumental.wav"
        }
        for src_name, dst_name in stem_map.items():
            src = os.path.join(demucs_dir, src_name)
            dst = os.path.join(output_dir, dst_name)
            if os.path.exists(src):
                import shutil
                shutil.copy2(src, dst)
                print(f"  -> {dst_name}")

    print(f"[OK] Stems separados em: {output_dir}")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python separate.py <input_file> <output_dir>", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    output_dir = sys.argv[2]
    separate_audio(input_file, output_dir)
