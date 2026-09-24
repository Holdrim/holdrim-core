# The orchestrator's unattended runner. The image holds no credential: the machine account's
# GitHub token and the Claude token arrive as environment variables at `docker run`, so an image
# that leaks leaks nothing, and the owner's own token never has a way in.
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m crew \
 && mkdir -p /home/crew/.secrets /home/crew/.config/gh \
 && chown -R crew:crew /home/crew/.secrets /home/crew/.config \
 && chmod 700 /home/crew/.secrets
USER crew
WORKDIR /home/crew
COPY --chown=crew run-orchestrator.sh setup.sh loop.sh ./
CMD ["bash", "run-orchestrator.sh"]
