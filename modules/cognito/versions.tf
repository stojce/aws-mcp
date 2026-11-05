terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      # aws_region.current.region was introduced in v6.
      source  = "hashicorp/aws"
      version = ">= 6, < 7"
    }
  }
}
