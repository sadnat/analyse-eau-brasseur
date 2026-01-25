# Étape de production
FROM nginx:alpine

# Définir le répertoire de travail
WORKDIR /usr/share/nginx/html

# Copier d'abord la configuration Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copier tous les fichiers statiques
COPY . .

# S'assurer que nginx peut lire les fichiers
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html

# Exposer le port 80
EXPOSE 80

# Démarrer Nginx
CMD ["nginx", "-g", "daemon off;"]
