# Stage 1 : Build - Compilation Tailwind CSS
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tailwind.config.js ./
COPY src/input.css ./src/
COPY index.html app.js water.js ./
COPY tests/ ./tests/

# Tests (node:test) : un échec interrompt le build
RUN npm test

RUN npx tailwindcss -i ./src/input.css -o ./styles.css --minify

# Empreinte de contenu (?v=dev → ?v=<md5>) : permet un cache navigateur long sans fichier périmé
RUN for f in app.js water.js styles.css; do \
        h=$(md5sum "$f" | cut -c1-10); \
        sed -i "s#$f?v=dev#$f?v=$h#" index.html; \
    done

# Stage 2 : Production - Nginx statique
FROM nginx:alpine
WORKDIR /usr/share/nginx/html

# Configuration Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Fichiers statiques
COPY favicon.svg ./

# HTML (empreintes injectées), JS et CSS compilé depuis le stage build
COPY --from=build /app/index.html /app/app.js /app/water.js /app/styles.css ./

# Permissions
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
