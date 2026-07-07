"""Launch Mona gateway with SiliconFlow STT environment variables."""
import os
import subprocess
import sys

# Set environment variables before starting gateway
os.environ["GROQ_API_KEY"] = "sk-ijxtqvlwlsdhyptytdkidssvymkpjvhajkmcwlceiknfeiql"
os.environ["GROQ_BASE_URL"] = "https://api.siliconflow.cn/v1/audio/transcriptions"
os.environ["GROQ_TRANSCRIPTION_MODEL"] = "FunAudioLLM/SenseVoiceSmall"

# Print config for verification
print("=== Environment Variables ===")
print(f"GROQ_API_KEY: {os.environ['GROQ_API_KEY'][:12]}...")
print(f"GROQ_BASE_URL: {os.environ['GROQ_BASE_URL']}")
print(f"GROQ_TRANSCRIPTION_MODEL: {os.environ['GROQ_TRANSCRIPTION_MODEL']}")
print("=== Starting Gateway ===")

# Start gateway with inherited environment
python_exe = r"d:\liuzhe\Desktop\code\Mona\.venv\Scripts\python.exe"
os.chdir(r"d:\liuzhe\Desktop\code\Mona")
result = subprocess.run([python_exe, "-m", "mona", "gateway"], env=os.environ)
sys.exit(result.returncode)
