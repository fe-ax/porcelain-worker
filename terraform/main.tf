data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
    account = {
      id = var.account_id
    }
  }
}

# The Worker's database. The Worker script itself is deployed by wrangler (see README).
resource "cloudflare_d1_database" "this" {
  account_id = var.account_id
  name       = var.database_name

  lifecycle {
    # Deleting the database deletes every device record. Never let a plan do it silently.
    prevent_destroy = true
    # Changed by the database itself (size, table count); not configuration.
    ignore_changes = [file_size, num_tables, version]
  }
}

# Binds the hostname to the Worker. The Worker must exist (first `wrangler deploy`) before this
# can be created; on an existing deployment it is adopted by imports.tf.
resource "cloudflare_workers_custom_domain" "this" {
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.this.zone_id
  hostname   = var.hostname
  service    = var.worker_name
}
