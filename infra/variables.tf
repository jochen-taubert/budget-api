variable "project_name" {
  description = "Präfix für alle Ressourcennamen"
  type        = string
  default     = "mobility-budget"

  validation {
    condition     = can(regex("^[a-z0-9-]{3,32}$", var.project_name))
    error_message = "Nur Kleinbuchstaben, Ziffern und Bindestriche, 3 bis 32 Zeichen."
  }
}

variable "aws_region" {
  description = "AWS-Region"
  type        = string
  default     = "eu-central-1"
}

variable "auth_mode" {
  description = "\"none\" für eine offene Demo, \"jwt\" für den JWT-Authorizer (Keycloak, Cognito o. a. OIDC-Provider)"
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "jwt"], var.auth_mode)
    error_message = "auth_mode muss \"none\" oder \"jwt\" sein."
  }
}

variable "oidc_issuer" {
  description = "Issuer-URL des Identity Providers, z. B. https://auth.example.de/realms/benefits (nur bei auth_mode = jwt)"
  type        = string
  default     = ""
}

variable "oidc_audience" {
  description = "Erwartete Audience im Access Token (bei Keycloak per Audience Mapper setzen)"
  type        = string
  default     = "benefits-api"
}

variable "log_retention_days" {
  description = "Aufbewahrung der CloudWatch-Logs in Tagen"
  type        = number
  default     = 14
}

variable "deletion_protection" {
  description = "Schützt die DynamoDB-Tabelle vor versehentlichem Löschen (für Produktion auf true setzen)"
  type        = bool
  default     = false
}
