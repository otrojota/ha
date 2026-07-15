FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/music-gateway/package.json services/music-gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev --workspace @ha/music-gateway --include-workspace-root
COPY services/music-gateway services/music-gateway
COPY packages/shared packages/shared
EXPOSE 3100
CMD ["npm", "run", "start", "--workspace", "@ha/music-gateway"]

