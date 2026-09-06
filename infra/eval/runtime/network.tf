data "aws_availability_zones" "available" { state = "available" }

resource "aws_vpc" "eval" {
  cidr_block           = "10.73.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
}

resource "aws_internet_gateway" "eval" { vpc_id = aws_vpc.eval.id }

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.eval.id
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  cidr_block              = cidrsubnet(aws_vpc.eval.cidr_block, 8, count.index)
  map_public_ip_on_launch = false
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.eval.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.eval.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "task" {
  name_prefix = "${var.name_prefix}-task-"
  description = "No ingress; HTTPS and DNS egress for ephemeral evaluation tasks"
  vpc_id      = aws_vpc.eval.id

  egress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS UDP"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [aws_vpc.eval.cidr_block]
  }

  egress {
    description = "DNS TCP"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.eval.cidr_block]
  }
}
