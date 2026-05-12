---
name: docker-compose
description: Docker Compose container orchestration, debugging, and management. Use when working with docker-compose.yml, container logs, networking, volumes, or multi-container applications.
---

# Docker Compose Skill

Manage multi-container Docker applications.

## Quick Reference

### Lifecycle Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# Restart specific service
docker-compose restart <service>

# Rebuild and restart
docker-compose up -d --build

# View status
docker-compose ps
```

### Logs & Debugging

```bash
# View logs (all services)
docker-compose logs -f

# View logs (specific service)
docker-compose logs -f <service>

# Last N lines
docker-compose logs --tail=100 <service>

# Execute command in container
docker-compose exec <service> <command>

# Shell into container
docker-compose exec <service> /bin/bash
docker-compose exec <service> /bin/sh  # Alpine
```

### Inspection

```bash
# List containers
docker-compose ps

# Show config (resolved)
docker-compose config

# Show service dependencies
docker-compose config --services

# Inspect network
docker network ls
docker network inspect <network>

# Inspect volumes
docker volume ls
docker volume inspect <volume>
```

## Common Patterns

### Health Checks

```yaml
services:
  web:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

### Depends On with Condition

```yaml
services:
  web:
    depends_on:
      db:
        condition: service_healthy
```

### Environment Files

```yaml
services:
  web:
    env_file:
      - .env
      - .env.local
```

### Volume Mounts

```yaml
volumes:
  # Named volume
  db_data:

services:
  db:
    volumes:
      - db_data:/var/lib/postgresql/data  # Named
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro  # Bind mount
```

### Nginx X-Accel-Redirect (for NAS streaming)

```nginx
location /protected/ {
    internal;
    alias /mnt/nas/;
}
```

```python
# Flask
return Response(headers={
    'X-Accel-Redirect': f'/protected/{filepath}',
    'Content-Type': mimetype
})
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose logs <service>

# Check config validity
docker-compose config

# Rebuild from scratch
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

### Port Already in Use

```bash
# Find process using port
lsof -i :<port>
# or
netstat -tulpn | grep <port>

# Kill process
kill -9 <pid>
```

### Network Issues

```bash
# Recreate network
docker-compose down
docker network prune
docker-compose up -d

# Test connectivity
docker-compose exec <service> ping <other-service>
docker-compose exec <service> curl http://<other-service>:<port>
```

### Volume Permission Issues

```bash
# Check ownership inside container
docker-compose exec <service> ls -la /path

# Fix permissions
docker-compose exec <service> chown -R <user>:<group> /path
```

### Clean Up

```bash
# Remove stopped containers
docker-compose rm

# Remove unused images
docker image prune

# Remove unused volumes (DANGER: data loss)
docker volume prune

# Full cleanup
docker system prune -a
```

## Best Practices

1. **Always use `-d`** for detached mode in production
2. **Pin image versions** - avoid `latest` tag
3. **Use `.env` files** - don't hardcode secrets
4. **Health checks** - ensure dependencies are ready
5. **Named volumes** - easier to manage than bind mounts for data
6. **Restart policies** - `restart: unless-stopped` for production
