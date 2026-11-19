FROM postgres:16
COPY entrypoint-ha.sh /usr/local/bin/entrypoint-ha.sh
COPY init-primary.sh /docker-entrypoint-initdb.d/10-init-primary.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint-ha.sh /docker-entrypoint-initdb.d/10-init-primary.sh \
 && chmod +x /usr/local/bin/entrypoint-ha.sh /docker-entrypoint-initdb.d/10-init-primary.sh
ENTRYPOINT ["entrypoint-ha.sh"]
CMD ["postgres"]
