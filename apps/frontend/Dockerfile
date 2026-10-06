FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm install

COPY apps/frontend apps/frontend
COPY packages/shared packages/shared

WORKDIR /app/apps/frontend

RUN npm --prefix /app/packages/shared run build

EXPOSE 3000

CMD ["npm", "run", "dev"]
