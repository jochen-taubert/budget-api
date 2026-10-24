output "api_url" {
  description = "Basis-URL der API"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "table_name" {
  value = aws_dynamodb_table.budgets.name
}

output "function_name" {
  value = aws_lambda_function.api.function_name
}

output "auth_mode" {
  value = var.auth_mode
}
