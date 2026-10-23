terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }

  # Partial configuration: the endpoint contains the account id, so it is passed at init time:
  #   terraform init -backend-config="endpoints={s3=\"https://<ACCOUNT_ID>.r2.cloudflarestorage.com\"}"
  # Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (an R2 API token's keys).
  backend "s3" {
    bucket = "porcelain-worker-tfstate"
    key    = "porcelain-worker/terraform.tfstate"
    region = "auto"

    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Authenticates with CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}
