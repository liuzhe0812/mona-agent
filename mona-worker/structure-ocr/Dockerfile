FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        libgomp1 \
        libglib2.0-0 \
        libgl1 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --upgrade pip \
    && python -m pip install \
        --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
        paddlepaddle==3.2.0

COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install -r /tmp/requirements.txt

RUN useradd --system --uid 995 --create-home --home-dir /app mona-worker
WORKDIR /app
COPY --chown=mona-worker:mona-worker app ./app
USER mona-worker

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
