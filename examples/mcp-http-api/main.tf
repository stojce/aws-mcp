terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6, < 7"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project = "mcp-http-api-example"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name = var.name

  test_users = var.test_users
}

# ── Example-only identity: a user pool that stands in for the app's pool ──────

resource "aws_cognito_user_pool" "example" {
  name                     = "${local.name}-pool"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }
}

resource "aws_cognito_user_pool_domain" "example" {
  domain       = "${local.name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.example.id
}

# Users are created with a fixed, non-sensitive key set. Passwords are NOT
# managed by Terraform (the AWS provider has no aws_cognito_user_password);
# scripts/set-test-passwords.sh sets them with `admin-set-user-password`.
resource "aws_cognito_user" "test" {
  for_each     = toset(keys(local.test_users))
  user_pool_id = aws_cognito_user_pool.example.id
  username     = local.test_users[each.key].email

  attributes = {
    email          = local.test_users[each.key].email
    email_verified = "true"
  }

  message_action = "SUPPRESS"
}

# ── Demo data: bookings keyed by owner sub ───────────────────────────────────

resource "aws_dynamodb_table" "bookings" {
  name         = "${local.name}-bookings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table_item" "demo" {
  for_each   = { for b in var.demo_bookings : "${b.owner_sub_key}#${b.id}" => b }
  table_name = aws_dynamodb_table.bookings.name
  hash_key   = aws_dynamodb_table.bookings.hash_key
  range_key  = aws_dynamodb_table.bookings.range_key

  item = jsonencode({
    pk     = { S = "USER#${aws_cognito_user.test[each.value.owner_sub_key].sub}" }
    sk     = { S = "BOOKING#${each.value.id}" }
    status = { S = each.value.status }
    title  = { S = each.value.title }
    when   = { S = each.value.when }
  })
}

# ── Tool backend Lambda (executes tools for the MCP Lambda) ──────────────────

data "archive_file" "tool_backend" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/tool-backend"
  output_path = "${path.module}/.build/tool-backend.zip"
}

resource "aws_iam_role" "tool_backend" {
  name = "${local.name}-tool-backend"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "tool_backend_logs" {
  role       = aws_iam_role.tool_backend.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "tool_backend_read" {
  name = "read-bookings"
  role = aws_iam_role.tool_backend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:Query"]
      Resource = aws_dynamodb_table.bookings.arn
    }]
  })
}

resource "aws_lambda_function" "tool_backend" {
  function_name    = "${local.name}-tool-backend"
  role             = aws_iam_role.tool_backend.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.tool_backend.output_path
  source_code_hash = data.archive_file.tool_backend.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      BOOKINGS_TABLE = aws_dynamodb_table.bookings.name
    }
  }

  depends_on = [aws_iam_role_policy_attachment.tool_backend_logs]
}

# ── The module under test ────────────────────────────────────────────────────

module "mcp" {
  source = "../../modules/mcp-http-api"

  name             = local.name
  user_pool_id     = aws_cognito_user_pool.example.id
  tool_backend_arn = aws_lambda_function.tool_backend.arn
  server_name      = "bookings-mcp"
  server_version   = "1.0.0"

  callback_urls = ["http://localhost:8080/callback"]

  enable_password_auth_for_tests = var.enable_password_auth_for_tests

  tools = [
    {
      name        = "get_my_bookings"
      description = "List the signed-in user's bookings. Optionally filter by status."
      input_schema = jsonencode({
        type = "object"
        properties = {
          status = { type = "string", enum = ["confirmed", "cancelled", "past"] }
        }
        required = []
      })
    },
  ]
}
