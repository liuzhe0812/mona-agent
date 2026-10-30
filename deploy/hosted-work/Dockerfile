# Operator supplies a reviewed Python 3.11+ Linux image pinned by digest.
# This Dockerfile is not invoked or downloaded by Mona desktop/runtime startup.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0
RUN mkdir -p /workspace && chown 1000:1000 /workspace
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["/bin/sleep"]
CMD ["infinity"]
