variable "account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "zone_name" {
  description = "DNS zone that hosts the Worker's hostname, e.g. example.com (TF_VAR_zone_name; the ZONE_NAME variable in CI)."
  type        = string
}

variable "hostname" {
  description = "Public hostname of the Worker, inside zone_name, e.g. api.example.com (TF_VAR_hostname; the WORKER_HOSTNAME variable in CI)."
  type        = string
}

variable "worker_name" {
  description = "Name of the Worker script (wrangler.toml `name`). Deployed by wrangler, not by Terraform."
  type        = string
  default     = "porcelain-api"
}

variable "database_name" {
  description = "Name of the D1 database (wrangler.toml `database_name`)."
  type        = string
  default     = "porcelain-api"
}

variable "import_d1_database_id" {
  description = "Id of an EXISTING D1 database to adopt on the first apply. Empty = nothing to adopt, a new database is created."
  type        = string
  default     = ""
}

variable "import_custom_domain_id" {
  description = "Id of an EXISTING Workers custom domain to adopt on the first apply. Empty = nothing to adopt."
  type        = string
  default     = ""
}
