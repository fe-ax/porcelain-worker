output "d1_database_id" {
  description = "UUID of the D1 database; wrangler.toml's database_id is rendered from it."
  value       = cloudflare_d1_database.this.id
}

output "custom_domain_id" {
  description = "Id of the Workers custom domain."
  value       = cloudflare_workers_custom_domain.this.id
}
