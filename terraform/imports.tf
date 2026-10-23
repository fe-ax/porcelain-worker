# Adopts the resources that were created by hand before Terraform took over. Import blocks are
# no-ops once the resource is in state, so they can stay. A fork with nothing to adopt deletes
# this file (or points the variables at its own ids).
#
# Id formats are "<account_id>/<id>" for both resources (provider v5). Verify with `terraform plan`.

import {
  to = cloudflare_d1_database.this
  id = "${var.account_id}/${var.import_d1_database_id}"
}

import {
  to = cloudflare_workers_custom_domain.this
  id = "${var.account_id}/${var.import_custom_domain_id}"
}
