# The orchestrator's unattended runner. The image holds no credential: the machine account's
# GitHub token and the Claude token arrive as environment variables at `docker run`, so an image
# that leaks leaks nothing, and the owner's own token never has a way in.
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
# Two users, so that the operating system, and not only a flag, keeps the model from the tokens:
# `crew` holds them in a home only it can read and runs the steps that talk to GitHub; `model` runs
# the model, with a home of its own and nothing else to read but /work. The container starts as
# root only so that run-orchestrator.sh can hand each step to its user; setup.sh runs as crew.
RUN useradd -m crew && useradd -m model \
 && mkdir -p /home/crew/.secrets /home/crew/.config/gh /home/crew/.state /work \
 && chown -R crew:crew /home/crew /work \
 && chmod 700 /home/crew /home/model /home/crew/.secrets
WORKDIR /home/crew
COPY run-orchestrator.sh board.js setup.sh loop.sh ./
CMD ["bash", "run-orchestrator.sh"]
