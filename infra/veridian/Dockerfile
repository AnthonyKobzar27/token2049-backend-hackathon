# KERIA for HAAS: upstream image plus an entrypoint that writes the agency config from env.
# Same image locally (docker-compose.yml) and on Railway.
FROM weboftrust/keria:0.4.0
COPY entrypoint.sh /usr/local/bin/haas-keria-entrypoint
ENTRYPOINT ["/usr/local/bin/haas-keria-entrypoint"]
CMD []
