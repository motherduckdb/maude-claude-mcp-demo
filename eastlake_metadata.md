# Eastlake Database Metadata

## Business Context

Eastlake is a fictitious B2B company that manufactures and sells products to businesses worldwide. The database contains transactional data including customers, orders, products, employees, and suppliers spanning from 2019 to 2026.

## Database: `eastlake`

### Tables Overview

| Table | Rows | Description |
|-------|------|-------------|
| categories | 8 | Product categories (Meat/Poultry, Grains/Cereals, Produce, Seafood, Confections, Beverages) |
| customers | 1,000 | Business customers across 21 countries |
| employees | 9 | Sales staff with titles and reporting structure |
| employee_territories | 49 | Maps employees to sales territories |
| orders | 163,452 | Customer orders with shipping details |
| order_details | 214,108 | Line items for each order (products, quantities, prices) |
| products | 77 | Products with pricing and inventory |
| regions | 4 | Sales regions (Southern, Western) |
| shippers | 3 | Shipping companies (United Package, Speedy Express, Federal Shipping) |
| suppliers | 29 | Product suppliers |
| territories | 53 | Sales territories linked to regions |

---

## Table Schemas

### categories
| Column | Type | Description |
|--------|------|-------------|
| category_id | BIGINT | Primary key |
| category_name | VARCHAR | Category name |
| description | VARCHAR | Category description |

### customers
| Column | Type | Description |
|--------|------|-------------|
| customer_id | VARCHAR | Primary key (5-char code) |
| company_name | VARCHAR | Business name |
| contact_name | VARCHAR | Primary contact |
| contact_title | VARCHAR | Contact's job title |
| address | VARCHAR | Street address |
| city | VARCHAR | City |
| region | VARCHAR | State/region |
| postal_code | VARCHAR | Postal/ZIP code |
| country | VARCHAR | Country |
| phone | VARCHAR | Phone number |
| fax | VARCHAR | Fax number |
| primary_category | INTEGER | Customer's primary product category preference |
| category_breadth | INTEGER | Number of different categories customer buys from |

### employees
| Column | Type | Description |
|--------|------|-------------|
| employee_id | BIGINT | Primary key |
| first_name | VARCHAR | First name |
| last_name | VARCHAR | Last name |
| title | VARCHAR | Job title (Sales Representative, Sales Manager, etc.) |
| title_of_courtesy | VARCHAR | Mr., Ms., Dr., etc. |
| birth_date | TIMESTAMP | Date of birth |
| hire_date | TIMESTAMP | Employment start date |
| address | VARCHAR | Street address |
| city | VARCHAR | City |
| region | VARCHAR | State/region |
| postal_code | VARCHAR | Postal code |
| country | VARCHAR | Country |
| home_phone | VARCHAR | Phone number |
| extension | VARCHAR | Office extension |
| reports_to | JSON | Manager's employee_id |

### orders
| Column | Type | Description |
|--------|------|-------------|
| order_id | BIGINT | Primary key |
| customer_id | JSON | Foreign key to customers (NOTE: stored with quotes, use REPLACE to join) |
| employee_id | BIGINT | Foreign key to employees |
| order_date | TIMESTAMP | Date order was placed |
| required_date | TIMESTAMP | Customer's requested delivery date |
| shipped_date | TIMESTAMP | Actual ship date |
| ship_via | BIGINT | Foreign key to shippers |
| freight | DECIMAL(18,3) | Shipping cost |
| ship_name | JSON | Recipient name |
| ship_address | JSON | Delivery address |
| ship_city | JSON | Delivery city |
| ship_region | JSON | Delivery state/region |
| ship_postal_code | JSON | Delivery postal code |
| ship_country | JSON | Delivery country |
| customer_primary_category | INTEGER | Denormalized from customer |
| customer_category_breadth | INTEGER | Denormalized from customer |

### order_details
| Column | Type | Description |
|--------|------|-------------|
| order_id | JSON | Foreign key to orders (stored as string) |
| product_id | JSON | Foreign key to products (stored as string) |
| unit_price | DECIMAL(18,3) | Price at time of order |
| quantity | INTEGER | Quantity ordered |
| discount | DECIMAL(18,3) | Discount percentage (0.0 to 1.0) |

### products
| Column | Type | Description |
|--------|------|-------------|
| product_id | BIGINT | Primary key |
| product_name | VARCHAR | Product name |
| supplier_id | BIGINT | Foreign key to suppliers |
| category_id | BIGINT | Foreign key to categories |
| quantity_per_unit | VARCHAR | Package size description |
| unit_price | DECIMAL(18,3) | Current list price |
| units_in_stock | INTEGER | Current inventory |
| units_on_order | INTEGER | Units on order from supplier |
| reorder_level | INTEGER | Minimum stock before reorder |
| discontinued | BOOLEAN | Whether product is discontinued |

### suppliers
| Column | Type | Description |
|--------|------|-------------|
| supplier_id | BIGINT | Primary key |
| company_name | VARCHAR | Supplier business name |
| contact_name | VARCHAR | Primary contact |
| contact_title | VARCHAR | Contact's job title |
| address | VARCHAR | Street address |
| city | VARCHAR | City |
| region | VARCHAR | State/region |
| postal_code | VARCHAR | Postal code |
| country | VARCHAR | Country |
| phone | VARCHAR | Phone number |

### shippers
| Column | Type | Description |
|--------|------|-------------|
| shipper_id | BIGINT | Primary key |
| company_name | VARCHAR | Shipper name |
| phone | VARCHAR | Phone number |

**Shippers:** United Package (1), Speedy Express (2), Federal Shipping (3)

### regions
| Column | Type | Description |
|--------|------|-------------|
| region_id | BIGINT | Primary key |
| region_description | VARCHAR | Region name |

**Regions:** Southern, Western

### territories
| Column | Type | Description |
|--------|------|-------------|
| territory_id | VARCHAR | Primary key |
| territory_description | VARCHAR | Territory name |
| region_id | BIGINT | Foreign key to regions |

### employee_territories
| Column | Type | Description |
|--------|------|-------------|
| employee_id | BIGINT | Foreign key to employees |
| territory_id | VARCHAR | Foreign key to territories |

---

## Key Relationships

```
customers.customer_id <-- orders.customer_id (NOTE: orders.customer_id has embedded quotes)
employees.employee_id <-- orders.employee_id
orders.order_id <-- order_details.order_id (order_details.order_id is VARCHAR)
products.product_id <-- order_details.product_id (order_details.product_id is VARCHAR)
categories.category_id <-- products.category_id
suppliers.supplier_id <-- products.supplier_id
shippers.shipper_id <-- orders.ship_via
regions.region_id <-- territories.region_id
territories.territory_id <-- employee_territories.territory_id
employees.employee_id <-- employee_territories.employee_id
```

### Important Join Notes

The `orders.customer_id` column stores values with embedded quotes (e.g., `"WZQHE"`). To join with customers:
```sql
JOIN customers c ON REPLACE(o.customer_id, '"', '') = c.customer_id
```

The `order_details.order_id` and `order_details.product_id` are stored as VARCHAR/JSON. To join:
```sql
JOIN order_details od ON o.order_id = CAST(od.order_id AS BIGINT)
JOIN products p ON CAST(p.product_id AS VARCHAR) = od.product_id
```

---

## Common Query Patterns

### Product Performance
```sql
SELECT
  p.product_name,
  c.category_name,
  COUNT(DISTINCT od.order_id) as order_count,
  SUM(od.quantity) as total_quantity,
  SUM(od.unit_price * od.quantity * (1 - od.discount)) as revenue
FROM products p
LEFT JOIN categories c ON p.category_id = c.category_id
LEFT JOIN order_details od ON CAST(p.product_id AS VARCHAR) = od.product_id
GROUP BY p.product_name, c.category_name
ORDER BY revenue DESC
```

### Customer Analysis
```sql
SELECT
  c.company_name,
  c.country,
  COUNT(DISTINCT od.product_id) as product_variety,
  COUNT(DISTINCT o.order_id) as order_count
FROM customers c
JOIN orders o ON REPLACE(c.customer_id, '"', '') = REPLACE(o.customer_id, '"', '')
JOIN order_details od ON o.order_id = CAST(od.order_id AS BIGINT)
GROUP BY c.company_name, c.country
ORDER BY product_variety DESC
```

### Sales by Geography
```sql
SELECT
  c.country,
  COUNT(DISTINCT o.order_id) as order_count,
  SUM(o.freight) as total_freight,
  COUNT(DISTINCT c.customer_id) as customer_count
FROM customers c
JOIN orders o ON REPLACE(c.customer_id, '"', '') = REPLACE(o.customer_id, '"', '')
GROUP BY c.country
ORDER BY order_count DESC
```

---

## Geographic Data

**Customer Countries (21):** Argentina, Austria, Belgium, Brazil, Canada, Denmark, Finland, France, Germany, Ireland, Italy, Mexico, Norway, Poland, Portugal, Spain, Sweden, Switzerland, UK, USA, Venezuela

**Top Markets by Order Volume:**
1. Venezuela - 18,502 orders, 45 customers
2. Poland - 18,092 orders, 42 customers
3. Finland - 15,420 orders, 38 customers
4. Belgium - 12,924 orders, 44 customers
5. Brazil - 12,801 orders, 43 customers

---

## Product Categories

| ID | Category Name |
|----|---------------|
| 1 | Meat/Poultry |
| 2 | Grains/Cereals |
| 3 | Produce |
| 4 | Seafood |
| 5 | Confections |
| 6 | Beverages |
| 7 | Confections |
| 8 | Grains/Cereals |

---

## Employee Roles

- Sales Representative (4 employees)
- Sales Manager (2 employees)
- Inside Sales Coordinator (2 employees)
- Vice President, Sales (1 employee)

---

## Date Range

Orders span from **July 2019** to **November 2026**.

---

## Sample Values

| Column | Examples |
|--------|----------|
| customers.customer_id | MMAUH, KRUES, BUNFB, KDEND, WZQHE |
| customers.contact_title | Owner, Sales Manager, Sales Representative, Marketing Manager, Accounting Manager, Order Administrator, Sales Associate |
| products.product_name | Durable Aluminum Watch, Aerodynamic Plastic Chair, Small Leather Shoes, Heavy Duty Cotton Bag, Gorgeous Leather Shoes |
| employees.title | Sales Representative, Sales Manager, Inside Sales Coordinator, Vice President Sales |
| territories.territory_id | 47647.09791718673, 76165.4595730574 (numeric strings) |
| orders.customer_id | "WZQHE", "LCXRE" (note: has embedded quotes) |
| order_details.order_id | "10248", "10249" (stored as strings) |

---

## Question-to-Table Guide

| Question Type | Primary Tables | Join Through |
|---------------|----------------|--------------|
| **Product performance/sales** | products, order_details | order_details.product_id |
| **Product categories** | products, categories | products.category_id |
| **Customer orders** | customers, orders | orders.customer_id (use REPLACE for quotes) |
| **Order line items/revenue** | orders, order_details | order_details.order_id |
| **Sales by employee** | employees, orders | orders.employee_id |
| **Sales by region/country** | customers, orders | orders.customer_id |
| **Shipping analysis** | orders, shippers | orders.ship_via |
| **Supplier products** | suppliers, products | products.supplier_id |
| **Employee territories** | employees, employee_territories, territories | employee_id, territory_id |
| **Inventory/stock levels** | products | (direct query) |

### Quick Patterns

- **Revenue calculation:** `SUM(od.unit_price * od.quantity * (1 - od.discount))`
- **Join orders↔customers:** `REPLACE(o.customer_id, '"', '') = c.customer_id`
- **Join orders↔order_details:** `o.order_id = CAST(od.order_id AS BIGINT)`
- **Join products↔order_details:** `CAST(p.product_id AS VARCHAR) = od.product_id`
