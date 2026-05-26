#!/bin/bash
# Runs once on first postgres container start.
# Creates the two product databases used by Strapi and Postiz.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE strapi;
    CREATE DATABASE postiz;
EOSQL
