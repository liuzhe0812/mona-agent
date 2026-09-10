FROM nvidia/cuda:12.1.1-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ffmpeg \
        libgomp1 \
        libsndfile1 \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install \
        --index-url https://mirrors.tuna.tsinghua.edu.cn/pytorch-wheels/cu121 \
        torch==2.5.1+cu121 \
        torchaudio==2.5.1+cu121

COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install -r /tmp/requirements.txt

RUN useradd --system --uid 995 --create-home --home-dir /app mona-worker
WORKDIR /app
COPY --chown=mona-worker:mona-worker app ./app
USER mona-worker

CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
