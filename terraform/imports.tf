# Adopts resources that were created by hand before Terraform took over. Each block is active only while its
# variable holds an id; with the defaults ("") nothing is imported and a fresh deployment creates both resources.
# Import blocks are no-ops once the resource is in state, so the variables can be cleared after the first apply.
#
# Id formats are "<account_id>/<id>" for both resources (provider v5). Verify with `terraform plan`.

import {
  for_each = var.import_d1_database_id == "" ? toset([]) : toset([var.import_d1_database_id])
  to       = cloudflare_d1_database.this
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = var.import_custom_domain_id == "" ? toset([]) : toset([var.import_custom_domain_id])
  to       = cloudflare_workers_custom_domain.this
  id       = "${var.account_id}/${each.value}"
}
