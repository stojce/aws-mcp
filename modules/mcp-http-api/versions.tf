terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      # The Cognito issuer uses aws_region.current.region, introduced in v6.
      source  = "hashicorp/aws"
      version = ">= 6, < 7"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}
