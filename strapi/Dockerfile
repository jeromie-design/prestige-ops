# Strapi 5 container.
# The Strapi project itself is initialized once (see README, "First-time Strapi init")
# and lives alongside this Dockerfile in the same directory.

FROM node:24-alpine

# Native deps Strapi needs (sharp / image processing, sqlite header just in case)
RUN apk add --no-cache build-base gcc autoconf automake zlib-dev libpng-dev nasm bash vips-dev git

WORKDIR /opt/app

ENV PATH=/opt/app/node_modules/.bin:$PATH

# Strapi admin panel build (Vite + React) is memory-hungry. Default V8 heap inside
# the container is too low and OOMs around ~940 MB. Bump to 3 GB explicitly.
ENV NODE_OPTIONS=--max-old-space-size=3072

# Install ALL deps (devDeps included — `npm run build` needs them to compile the admin panel)
COPY package*.json ./
RUN npm install

# Copy the rest of the project and build the admin panel
COPY . .
RUN npm run build

EXPOSE 1337

CMD ["npm", "start"]
