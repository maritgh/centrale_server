FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY database ./database

ENV NODE_ENV=production
EXPOSE 3001

CMD ["npm", "start"]
