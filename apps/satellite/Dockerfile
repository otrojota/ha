FROM node:20-alpine
RUN apk add --no-cache pulseaudio-utils
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/satellite/package.json apps/satellite/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev --workspace @ha/satellite --include-workspace-root
COPY apps/satellite apps/satellite
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
EXPOSE 3200
CMD ["npm", "run", "start", "--workspace", "@ha/satellite"]
