FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev --workspace @ha/server --include-workspace-root
COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@ha/server"]

