# Stage 1 : Build - Compilation Tailwind CSS
FROM node:alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tailwind.config.js ./
COPY src/input.css ./src/
COPY index.html app.js ./
RUN npx tailwindcss -i ./src/input.css -o ./styles.css --minify

# Stage 2 : Production - Nginx statique
FROM nginx:alpine
WORKDIR /usr/share/nginx/html

# Configuration Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Fichiers statiques
COPY index.html app.js favicon.svg ./

# CSS compile depuis le stage build
COPY --from=build /app/styles.css ./

# Permissions
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
