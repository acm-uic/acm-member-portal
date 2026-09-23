variable "tenant_id" {
  type        = string
  description = "The ACM Entra tenant GUID (single-tenant lock)."
}

variable "deployment_env" {
  type        = string
  description = "dev | prod — used to name app registration + secrets."
  default     = "dev"
}

variable "redirect_uris" {
  type        = list(string)
  description = "OAuth2 redirect URIs registered with the app."
  default = [
    "http://portal.acmuic.org/api/auth/callback/microsoft",
  ]
}

variable "logout_uris" {
  type        = list(string)
  description = "Front-channel logout URIs."
  default     = ["http://portal.acmuic.org"]
}

variable "kubernetes_namespace" {
  type    = string
  default = "acm-portal"
}
