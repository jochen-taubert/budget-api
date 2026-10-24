# Offline-Tests der Terraform-Konfiguration: "terraform test" (ab 1.7).
# Der AWS-Provider ist gemockt, es werden keine Credentials gebraucht und nichts angelegt.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  # Der Provider validiert ARNs schon beim Plan, deshalb plausible Platzhalter.
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-central-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:eu-central-1:123456789012:table/mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:eu-central-1:123456789012:function:mock"
      invoke_arn = "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-central-1:123456789012:function:mock/invocations"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:eu-central-1:123456789012:mockapi" }
  }
}

run "demo_modus_ohne_authorizer" {
  command = plan

  variables {
    auth_mode = "none"
  }

  assert {
    condition     = length(aws_apigatewayv2_authorizer.jwt) == 0
    error_message = "Im Demo-Modus darf kein Authorizer angelegt werden."
  }

  assert {
    condition     = alltrue([for r in aws_apigatewayv2_route.this : r.authorization_type == "NONE"])
    error_message = "Im Demo-Modus müssen alle Routen offen sein."
  }

  assert {
    condition     = length(aws_apigatewayv2_route.this) == 3
    error_message = "Es werden genau drei Routen erwartet."
  }
}

run "jwt_modus_schuetzt_alle_routen" {
  command = plan

  variables {
    auth_mode   = "jwt"
    oidc_issuer = "https://auth.example.de/realms/benefits"
  }

  assert {
    condition     = length(aws_apigatewayv2_authorizer.jwt) == 1
    error_message = "Im JWT-Modus muss genau ein Authorizer existieren."
  }

  assert {
    condition     = alltrue([for r in aws_apigatewayv2_route.this : r.authorization_type == "JWT"])
    error_message = "Im JWT-Modus müssen alle Routen geschützt sein."
  }

  assert {
    condition     = aws_apigatewayv2_route.this["PUT /employees/{employeeId}/budgets/{month}"].authorization_scopes == toset(["budget:admin"])
    error_message = "Budget setzen muss den Scope budget:admin verlangen."
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables.AUTH_MODE == "jwt"
    error_message = "Die Lambda muss den Auth-Modus kennen."
  }
}

run "jwt_ohne_issuer_wird_abgelehnt" {
  command = plan

  variables {
    auth_mode = "jwt"
  }

  expect_failures = [aws_apigatewayv2_authorizer.jwt]
}

run "ungueltiger_auth_mode_wird_abgelehnt" {
  command = plan

  variables {
    auth_mode = "basic"
  }

  expect_failures = [var.auth_mode]
}

run "tabelle_mit_ttl_und_backup" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.budgets.ttl[0].attribute_name == "ttl" && aws_dynamodb_table.budgets.point_in_time_recovery[0].enabled
    error_message = "Tabelle braucht TTL für Idempotenz-Einträge und Point-in-Time-Recovery."
  }

  assert {
    condition     = aws_lambda_function.api.runtime == "nodejs22.x" && aws_lambda_function.api.architectures == tolist(["arm64"])
    error_message = "Lambda soll auf nodejs22.x und arm64 laufen."
  }
}
