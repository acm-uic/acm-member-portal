terraform {
  required_version = ">= 1.7"

  required_providers {
    azuread    = { source = "hashicorp/azuread", version = "~> 3.9" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
    time       = { source = "hashicorp/time", version = "~> 0.11" }
  }

  backend "s3" {
    bucket         = "acm-portal-tfstate"
    key            = "terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "acm-portal-tflock"
    encrypt        = true
  }
}

provider "azuread" {}

provider "kubernetes" {
  config_path = "~/.kube/config"
}
