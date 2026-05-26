# Strapi 5 container.
# The Strapi project itself is initialized once (see README, "First-time Strapi init")
# and lives alongside this Dockerfile in the same directory.

FROM node:24-alpine

RUN apk add --no-cache build-base gcc autoconf automake zlib-dev libpng-dev nasm bash vips-dev git

WORKDIR /opt/app

ENV PATH=/opt/app/node_modules/.bin:$PATH

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN npm run build

EXPOSE 1337

CMD ["npm", "start"]
