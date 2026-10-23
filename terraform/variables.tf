variable "account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "zone_name" {
  description = "DNS zone that hosts the Worker's hostname."
  type        = string
  default     = "fe.ax"
}

variable "hostname" {
  description = "Public hostname of the Worker (must be inside zone_name)."
  type        = string
  default     = "porcelain-api.fe.ax"
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
  default     = "d2e39cbd-afcc-498a-a506-526d03949766"
}

variable "import_custom_domain_id" {
  description = "Id of an EXISTING Workers custom domain to adopt on the first apply. Empty = nothing to adopt."
  type        = string
  default     = "d193b1f1c29952dd5c000bd4bc243fb06b7580e3"
}
