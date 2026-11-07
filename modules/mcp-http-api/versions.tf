terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      # Keep the provider new enough to recognize the Node.js 26 Lambda runtime.
      source  = "hashicorp/aws"
      version = ">= 6.69.1, < 7"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}
