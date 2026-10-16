# ──────────────────────────────────────────────────────────────────────────────
# 5. Interceptor Lambda (request interceptor) — the per-user identity channel
# ──────────────────────────────────────────────────────────────────────────────

data "archive_file" "interceptor" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/interceptor"
  output_path = "${path.module}/.build/interceptor.zip"
}

resource "aws_iam_role" "interceptor" {
  name = "${local.gateway_name}-interceptor"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "sts:AssumeRole"
      Principal = {
        Service = ["lambda.amazonaws.com", "bedrock-agentcore.amazonaws.com"]
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "interceptor_logs" {
  role       = aws_iam_role.interceptor.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "interceptor" {
  function_name = "${local.gateway_name}-interceptor"
  role          = aws_iam_role.interceptor.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  timeout       = 5
  memory_size   = 128

  filename         = data.archive_file.interceptor.output_path
  source_code_hash = data.archive_file.interceptor.output_base64sha256

  # The interceptor signs the injected claims with this secret; the target's
  # context guard verifies it. Shared secret, never client-visible.
  environment {
    variables = {
      MCP_CLAIMS_SIGNING_SECRET = aws_ssm_parameter.mcp_claims_signing_secret.value
    }
  }

  # CloudWatch logging only. No JWT content (sub/email included) is logged.
  tracing_config {
    mode = "PassThrough"
  }
}

# HMAC key for the claims channel. SSM SecureString; the interceptor reads it
# via environment variable, no inline secret in state… except the value:
# SSM SecureString values are NOT stored in tfstate, only the name is.
resource "random_password" "mcp_claims" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "mcp_claims_signing_secret" {
  name  = "/${local.gateway_name}/claims-signing-secret"
  type  = "SecureString"
  value = random_password.mcp_claims.result
}
