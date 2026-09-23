# Holdrim — reviewable documentation, with traceable approval.
#
# Start it, sign in with user and password, and it is ready. No cloud, no identity provider, no
# database to install.
#
#   docker build -t holdrim .
#   docker run -p 8080:8080 -v data:/data -e HOLDRIM_OWNER=you@example.org holdrim
#
# The first-access password appears ONCE in the log, and the first sign-in forces a change. There
# is no admin/admin: an internal tool stays up for years.
#
# To point it at YOUR documentation, mount it and say where it is:
#
#   docker run -p 8080:8080 -v data:/data \
#     -v "$PWD/my-docs:/content" -e HOLDRIM_SITE=/content \
#     -e HOLDRIM_OWNER=you@example.org holdrim
#
# `/content` needs a holdrim.json. See examples/hello-world/ for the smallest thing that works.

# Base by DIGEST, not by tag: `node:24-alpine` changes on its own with every patch, and the image
# would change with no commit — nothing would point at it.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so the layer is reused when only the code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# No build step: Node 22.18+ runs TypeScript directly (type stripping). There is no tsc, no bundler,
# no dist/. Whoever adopts it clones and runs.
COPY engine ./engine
COPY examples ./examples
COPY holdrim.json ./holdrim.json

# The React panel is bundled (`npm run build:web`) and the result is VERSIONED — which is why it
# arrives here with no build step in the image. A bundle that only existed after `npm install`
# would break the "clone and run" promise.

# The database lives OUTSIDE /app, in a volume. Without this SQLite writes into a container layer:
# the service starts, answers, accepts an approval — and loses everything when recreated.
# ⚠️ With a HOST FOLDER instead of a named volume, the owner comes from the host and this chown
# does not reach it. Use a named volume, or `sudo chown 1000:1000` on the folder.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

ENV PORT=8080 \
    HOLDRIM_SITE=/app/examples/hello-world \
    HOLDRIM_EVENTS_PATH=/data/events.db \
    HOLDRIM_USERS_PATH=/data/users.db

EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "engine/api/server.ts"]
