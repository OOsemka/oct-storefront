FROM docker.io/library/node:20-alpine AS build

WORKDIR /app

RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY . .
RUN rm -rf dist && NODE_ENV=production yarn webpack --config webpack.config.js

FROM docker.io/library/nginx:1.27-alpine

# OpenShift runs the container with a random UID in group 0: give group 0 the
# owner's rights instead of making everything world-writable.
RUN chown -R 1001:0 /var/cache/nginx /var/run /var/log/nginx /usr/share/nginx/html /etc/nginx \
 && chmod -R g=u /var/cache/nginx /var/run /var/log/nginx /usr/share/nginx/html /etc/nginx

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

USER 1001

ENTRYPOINT ["nginx", "-g", "daemon off;"]
