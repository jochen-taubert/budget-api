locals {
  jwt_enabled = var.auth_mode == "jwt"

  # Route -> erforderliche Scopes (greifen nur im JWT-Modus).
  # Feinere Regeln (Mandant, "nur eigene Daten") prüft der Lambda-Code.
  routes = {
    "PUT /employees/{employeeId}/budgets/{month}" = ["budget:admin"]
    "GET /employees/{employeeId}/budgets/{month}" = ["budget:read"]
    "POST /employees/{employeeId}/expenses"       = ["expense:write"]
  }
}

resource "aws_apigatewayv2_api" "this" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 50
    throttling_burst_limit = 100
  }

  # Eine JSON-Zeile pro Request; requestId taucht auch in den Lambda-Logs auf.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId     = "$context.requestId"
      routeKey      = "$context.routeKey"
      status        = "$context.status"
      latencyMs     = "$context.responseLatency"
      authError     = "$context.authorizer.error"
      integrationMs = "$context.integrationLatency"
    })
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# Prüft Signatur (über JWKS des Issuers), exp/nbf, iss und aud – bevor die Lambda startet.
resource "aws_apigatewayv2_authorizer" "jwt" {
  count = local.jwt_enabled ? 1 : 0

  api_id           = aws_apigatewayv2_api.this.id
  authorizer_type  = "JWT"
  name             = "${local.name}-jwt"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = var.oidc_issuer
    audience = [var.oidc_audience]
  }

  lifecycle {
    precondition {
      condition     = startswith(var.oidc_issuer, "https://")
      error_message = "Bei auth_mode = \"jwt\" muss oidc_issuer eine https-URL sein."
    }
  }
}

resource "aws_apigatewayv2_route" "this" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"

  authorization_type   = local.jwt_enabled ? "JWT" : "NONE"
  authorizer_id        = local.jwt_enabled ? aws_apigatewayv2_authorizer.jwt[0].id : null
  authorization_scopes = local.jwt_enabled ? each.value : null
}
